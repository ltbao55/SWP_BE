package com.swp391.datalabeling.repository;

import com.swp391.datalabeling.entity.Review;
import com.swp391.datalabeling.enums.ReviewStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface ReviewRepository extends JpaRepository<Review, Long> {
    List<Review> findByTaskId(Long taskId);
    List<Review> findByReviewerId(Long reviewerId);
    List<Review> findByStatus(ReviewStatus status);
}
