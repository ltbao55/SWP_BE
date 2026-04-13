package com.swp391.datalabeling.repository;

import com.swp391.datalabeling.entity.DataItem;
import com.swp391.datalabeling.enums.DataItemStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface DataItemRepository extends JpaRepository<DataItem, Long> {
    List<DataItem> findByDatasetId(Long datasetId);
    List<DataItem> findByStatus(DataItemStatus status);
    long countByDatasetId(Long datasetId);
    long countByDatasetIdAndStatus(Long datasetId, DataItemStatus status);
}
