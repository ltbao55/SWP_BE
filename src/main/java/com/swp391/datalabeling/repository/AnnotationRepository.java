package com.swp391.datalabeling.repository;

import com.swp391.datalabeling.entity.Annotation;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface AnnotationRepository extends JpaRepository<Annotation, Long> {
    List<Annotation> findByTaskId(Long taskId);
    void deleteByTaskId(Long taskId);
}
